#-------------------------------------------------------------------------------
# Function Practice
#-------------------------------------------------------------------------------




# Number One - A function that does not return any value or take any arguments.
# This code is run any time the function is called. When the function code ends
# program control returns to where the function was called from.
'''
def hello_class():
    print("Good morning, computer scientists!")

hello_class()   #this is a function call, and initiates the code inside helloClass() to run.
'''


# Number Two - a function can require arguments to be passed in (as values), that are used inside the
# function code.
'''
def sum_two(num1, num2):
    print(num1 + num2)


number = 6

sum_two(2,3)       #can call with two literal values as arguments
sum_two(5,number)  # can call with a variable of the correct type as an argument
'''

# Challenge One:    Write a function called strange_math that requires 3 Arguments (assume they will be integers).
#                   This function should multiply the first two, and then divide by the third. Print the result.
#                   It should work with the sample function calls below and print the correct output.


'''
strange_math(4,5,2)  #should print out 10
strange_math(11,17,3)  #should print out 62
'''

# Number Three - a function can (and often should) return the output of the function rather than printing it.
# The line of code that makes the function call can use this returned result to print, store in a variable, or as
# an argument to another function.
'''
def greetings(name):
    result = "Nice to meet you, " + name    #'+' operator when used with a string will concatonate two values together!
    return result


response = greetings("Mr. Scott")    #Here is an example of storing the returned output in a varible to store later.
print(response)

print(greetings("Mr. Scott's Clone"))#Similar, but instead we will directly print out the return value

sum_two(greetings("Mr. Scott"),greetings("Mr. Scott's Clone"))  #Here we use the return value as an argument of another function.
                                                                # What do you think this line of code will cause to happen?
'''

#Challenge Two:     Write a function called Bigger_than_ten that takes in a single arguement (an integer). If the argument is larger
#                   than 10, return a Boolean value True. If it is 10 or less, return False. Store the result of this function (you
#                   may pass in any argument value you like) in a variable called num_result.

